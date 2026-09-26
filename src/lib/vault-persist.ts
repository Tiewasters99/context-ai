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
// The matter-tree document read, paged past PostgREST's 1,000-row cap. It
// lives in its own module because it takes the client as an argument, which
// is what lets an offline harness drive the real query.
import {
  fetchMatterDocumentRows,
  type DocumentsSource,
  type FetchMatterDocumentsOptions,
  type VaultDocumentRow,
} from './vault-documents';
// The pipeline's own accepted-types list and storage cap (lib/ingest-formats.mjs
// is dependency-free and shared with the Node side), so the pre-upload
// refusals here can never drift from what /api/ingest actually handles.
import type { OcrPending } from '../../lib/ingest-formats.mjs';
import { checkUpload, type UploadRefusal } from '../../lib/ingest-formats.mjs';
// The estimate's shared arithmetic — the same module /api/ingest re-checks
// with, so the body this file sends and the figure the handler recomputes can
// never come from two different ideas of what a page costs.
import {
  chooseDeclaration,
  declarationFor,
  documentNeedsConfirmation,
  estimateUploadItem,
  ingestRequestBody,
  type IngestDeclaration,
} from '../../lib/ingest-estimate.mjs';
// Resumable (TUS) uploads for large files (Phase 4): the same dependency-free
// module the Node smoke test drives against the real bucket.
import { uploadResumable, shouldUploadResumable, storageResumeStore, type UploadProgress } from '../../lib/tus-upload.mjs';
// A 402/429 from /api/ingest has no UI of its own — the upload simply never
// finishes. reportServerRefusal puts one sentence in front of the person.
import { reportServerRefusal } from './refusal-bus';

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
//
// Both reads are paged (see vault-documents.ts). They return the rows they
// hold AND what the server says exists, because those two numbers are only
// the same while the list is whole — and a list that is short without saying
// so is the bug this pagination exists to remove.
// -----------------------------------------------------------------------------

export interface VaultFileList {
  files: VaultFile[];
  /** What the server counts in these matters — exact, even if `files` is windowed. */
  total: number;
  /** The ceiling stopped the read. The surface owes the reader `showingOf()`. */
  truncated: boolean;
  /**
   * An A–Z or Category read was asked for and this database has not got
   * migration 081 yet, so the date list came back instead. The surface owes
   * the reader one sentence saying which list they are looking at.
   */
  orderFellBack?: boolean;
}

export async function listMatterDocuments(
  matterspaceId: string,
  options: FetchMatterDocumentsOptions = {},
): Promise<VaultFileList> {
  return listMatterDocumentsRecursive([matterspaceId], new Map(), options);
}

// Hydrate from a set of matter ids (parent + descendants). Each row carries
// matterspace_id + matterspace_name so the Vault file list can group by matter.
export async function listMatterDocumentsRecursive(
  matterIds: string[],
  nameById: Map<string, string>,
  options: FetchMatterDocumentsOptions = {},
): Promise<VaultFileList> {
  if (matterIds.length === 0) return { files: [], total: 0, truncated: false };
  const { rows, total, truncated, orderFellBack } = await fetchMatterDocumentRows(
    supabase as unknown as DocumentsSource,
    matterIds,
    options,
  );
  return {
    files: rows.map((d: VaultDocumentRow) => documentToVaultFile(d, nameById.get(d.matterspace_id))),
    total,
    truncated,
    orderFellBack,
  };
}

// -----------------------------------------------------------------------------
// "Organize my matter" and the category a person sets by hand (migration 081).
//
// Both are RPCs rather than table writes: the organize pass has to be ONE
// statement over the whole matter tree (7,600 round trips is not a feature),
// and both go through an INVOKER wrapper that decides what the caller may
// write before anything is written. A database without 081 answers 404 —
// which reads here as a plain sentence, not a stack trace.
// -----------------------------------------------------------------------------

const NEEDS_081 = 'Organizing arrives with migration 081 — ask Eden to apply it.';

function is404(message: string): boolean {
  return /PGRST202|could not find the function|does not exist/i.test(message);
}

/** Files every document in these matters by the deterministic rule. Returns
 *  how many rows actually changed — a second run legitimately returns 0. */
export async function organizeMatterDocuments(matterIds: string[]): Promise<number> {
  if (matterIds.length === 0) return 0;
  const { data, error } = await supabase.rpc('organize_matter_documents', {
    p_matterspace_ids: matterIds,
  } as never);
  if (error) throw new Error(is404(error.message) ? NEEDS_081 : error.message);
  const rows = (data ?? []) as { assigned: number | string }[];
  return rows.reduce((n, r) => n + Number(r.assigned ?? 0), 0);
}

/** Set one document's category by hand — or pass null to hand it back to the
 *  rule. The server records `category_source = 'user'`, which is what makes
 *  the organize pass skip the row from then on. */
export async function setDocumentCategory(
  documentId: string,
  category: string | null,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('set_document_category', {
    p_document_id: documentId,
    p_category: category,
  } as never);
  if (error) throw new Error(is404(error.message) ? NEEDS_081 : error.message);
  return (data as string | null) ?? null;
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
  /** Migration 081; present only on an A-Z or Category read. */
  sort_key?: string | null;
  category?: string | null;
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
    sortKey: doc.sort_key ?? undefined,
    category: doc.category ?? null,
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
  /**
   * What the upload gate decided for THIS file. Three states, and they are
   * not interchangeable (see chooseDeclaration):
   *   an object — a quote was shown and confirmed;
   *   null      — the file was measured and no quote was owed, so the ingest
   *               request is byte-for-byte what it has always been;
   *   absent    — nobody measured it. Every caller that files a document the
   *               APP made (a Record export, a combined exhibit PDF, a trial
   *               outline) is in this state, and gets an estimate formed from
   *               the file's name and size.
   */
  ingestDeclaration?: IngestDeclaration | null;
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
  void postIngest(
    doc.id,
    accessToken,
    chooseDeclaration(opts.ingestDeclaration, { name: file.name, bytes: file.size }),
  );

  return { documentId: doc.id, storagePath };
}


// -----------------------------------------------------------------------------
// The one POST to /api/ingest, and the one place its refusals are handled.
//
// The endpoint can now answer 402 (the month's AI budget is spent) or 429 (the
// rate window) before it writes anything at all — migration 063, PR #161. That
// is the quietest failure in the product: the documents row was inserted by
// this browser a moment ago and still says 'pending', the server refused
// before it could touch it, and watchDocumentStatus polls a row that will
// never change. The file sits in the Vault spinning for ever, and the person
// is told nothing.
//
// So two things happen here. The refusal is shown once, in a sentence, through
// the shared banner; and the row is marked 'error' with that same sentence, so
// the Vault list is honest when the person comes back to it tomorrow. The row
// update runs under the user's own session, exactly like every other write in
// this file, so RLS decides whether it is allowed.
// -----------------------------------------------------------------------------
async function postIngest(
  documentId: string,
  accessToken: string,
  declaration?: IngestDeclaration | null,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: ingestRequestBody(documentId, declaration),
    });
  } catch (err) {
    console.error('ingest fetch:', err);
    return;
  }
  if (res.ok) return;

  const refusal = await reportServerRefusal(res);
  console.error('ingest refused:', refusal.status, refusal.code ?? '');
  // Leave the row alone on a 5xx: the server may still be working, and
  // /api/ingest writes its own 'error'/'held' status on the paths it reaches.
  if (refusal.status >= 500) return;
  await supabase
    .from('documents')
    .update({ processing_status: 'error', processing_error: refusal.message.slice(0, 500) })
    .eq('id', documentId);
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

// -----------------------------------------------------------------------------
// Is the pipeline actually running? (migration 066)
//
// watchDocumentStatus below polls one row every 2 s and will do so forever —
// which is the right behaviour while the pipeline is working and exactly the
// wrong one when it is not. Before this, a worker outage looked identical to a
// slow scan: a spinner, no words, no end. The person's reasonable conclusion
// is that they did something wrong, so they delete the document and upload it
// again, which queues a second copy behind the first.
//
// `ingest_status_for_me()` is the answer, and it is deliberately narrow: no
// arguments, SECURITY INVOKER, so RLS and auth.uid() decide what it can count.
// It returns the caller's OWN queue numbers and the GLOBAL liveness facts —
// never another tenant's anything.
//
// Every failure path returns null, and null means "behave exactly as before".
// That covers the case that matters most in the next few days: 066 is not
// pasted yet, PostgREST answers PGRST202, and the Vault must carry on
// unchanged rather than showing an error about its own health check.
// -----------------------------------------------------------------------------
import type { IngestServiceStatus } from './ingest-service-notice';
export type { IngestServiceStatus, IngestServiceNotice } from './ingest-service-notice';
export { ingestServiceNotice, WORKER_SILENT_SECONDS, PROCESSING_PATIENCE_SECONDS } from './ingest-service-notice';

export async function fetchIngestServiceStatus(): Promise<IngestServiceStatus | null> {
  try {
    const { data, error } = await supabase.rpc('ingest_status_for_me');
    if (error || !data) return null;
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    if (!row) return null;
    const num = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null;
    return {
      workerAlive: row.worker_alive === true,
      secondsSinceBeat: num(row.seconds_since_beat),
      queueDepth: num(row.queue_depth) ?? 0,
      oldestQueuedSeconds: num(row.oldest_queued_seconds),
      myProcessing: num(row.my_processing) ?? 0,
      myOldestSeconds: num(row.my_oldest_seconds),
    };
  } catch {
    return null;
  }
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

/** One document's share of a batched status tick. */
export interface DocumentStatusRow {
  documentId: string;
  update: DocumentStatusUpdate;
}

/**
 * Ids per request. supabase-js puts `.in()` in the QUERY STRING, and a UUID
 * costs about 39 characters once encoded — 100 ids plus the select columns
 * sits comfortably inside the 8 KB request line the proxy in front of
 * PostgREST will accept, where 200 does not. #168 cut the same `.in()` to 100
 * in the same stack; this matches it rather than inventing a second number.
 */
const STATUS_CHUNK = 100;

/**
 * Consecutive failed ticks before the poll gives up. A transient failure must
 * not end the watch — that is the whole reason for retrying — but retrying
 * FOREVER is how a row spins on "processing" with nothing wrong with the
 * document and nothing said to the person. The single-document watcher
 * reported the error and stopped; so does this one, after about ten seconds.
 */
const STATUS_MAX_FAILED_TICKS = 5;

/**
 * Follow MANY documents' pipeline status with one request per chunk.
 *
 * The Vault opened one `watchDocumentStatus` poll per unfinished document on
 * hydration, and that was survivable only because the list itself stopped at
 * PostgREST's 1,000 rows. With the list paged, a matter caught mid-bulk-ingest
 * would have opened thousands of two-second polls and the tab would have spent
 * its life in the network queue — the pagination fix would have traded a silent
 * truncation for a frozen browser. One `.in('id', …)` per 200 ids does the same
 * work, and an id leaves the set the moment it reaches a terminal state, so the
 * traffic falls away as the pipeline finishes.
 *
 * Updates arrive in batches so the caller writes state once per chunk instead
 * of once per document. A document that a successful query does not return is
 * gone (deleted, or no longer visible) and is reported as such, exactly as the
 * single-document watcher does — never left spinning.
 */
export function watchDocumentStatuses(
  documentIds: string[],
  onUpdate: (rows: DocumentStatusRow[]) => void,
  intervalMs = 2000,
): () => void {
  const pending = new Set(documentIds);
  if (pending.size === 0) return () => {};

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failedTicks = 0;

  const tick = async () => {
    if (stopped) return;
    const ids = Array.from(pending);
    let tickFailed = false;
    let lastError = 'the status check kept failing';

    for (let i = 0; i < ids.length && !stopped; i += STATUS_CHUNK) {
      const chunk = ids.slice(i, i + STATUS_CHUNK);
      const { data, error } = await supabase
        .from('documents')
        .select('id, processing_status, processing_error, text_status:metadata->>text_status, ocr_pending:metadata->ocr_pending')
        .in('id', chunk);
      if (stopped) return;
      // A transient failure is not an answer about any document: keep them
      // all pending and ask again on the next tick. It is only counted, so
      // that a failure which never clears ends the watch instead of leaving
      // the rows spinning (see STATUS_MAX_FAILED_TICKS).
      if (error) { tickFailed = true; lastError = error.message; continue; }

      const rows = (data ?? []) as {
        id: string;
        processing_status: string;
        processing_error: string | null;
        text_status?: string | null;
        ocr_pending?: unknown;
      }[];
      const seen = new Set(rows.map((r) => r.id));
      const updates: DocumentStatusRow[] = [];

      for (const row of rows) {
        const status = mapStatus(row.processing_status);
        updates.push({
          documentId: row.id,
          update: {
            status,
            errorMessage: row.processing_error || undefined,
            stage: stageOf(row.processing_status),
            textStatus: row.processing_status === 'ready' ? (row.text_status ?? undefined) : undefined,
            ocrPending: row.processing_status === 'ready' && row.ocr_pending && typeof row.ocr_pending === 'object'
              ? (row.ocr_pending as OcrPending) : undefined,
            held: row.processing_status === 'held' || undefined,
          },
        });
        if (status === 'indexed' || status === 'error') pending.delete(row.id);
      }
      for (const id of chunk) {
        if (seen.has(id)) continue;
        updates.push({ documentId: id, update: { status: 'error', errorMessage: 'document disappeared' } });
        pending.delete(id);
      }

      if (updates.length) onUpdate(updates);
    }
    if (stopped) return;

    failedTicks = tickFailed ? failedTicks + 1 : 0;
    if (failedTicks >= STATUS_MAX_FAILED_TICKS) {
      // Say so on every row still waiting, then stop. Silence here reads as
      // "still working" forever.
      const stuck = Array.from(pending);
      pending.clear();
      if (stuck.length) {
        onUpdate(stuck.map((id) => ({
          documentId: id,
          update: { status: 'error' as const, errorMessage: `Couldn't check progress — ${lastError}. Reload to see where this got to.` },
        })));
      }
      return;
    }

    if (pending.size === 0) return;
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
    // 098: leaving a sealed matter needs this session's second factor.
    if (msg === 'step_up_required') {
      msg = 'Moving this out of a sealed matter takes it out of the seal. Open the sealed matter, confirm it’s you, then move it again.';
    }
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
  // Clear the terminal state FIRST. Vault.tsx's retry re-subscribes
  // watchDocumentStatus the moment it calls this, and that poll stops as soon
  // as it reads a terminal status — so against a row still saying 'error' it
  // would report the OLD message and stop, and a refusal written a moment
  // later would not appear until the page was reloaded. saveDocumentText
  // already does this for the same reason.
  await supabase
    .from('documents')
    .update({ processing_status: 'pending', processing_error: null })
    .eq('id', documentId);
  // Same POST, same refusal handling. Retry (Vault.tsx) and re-ingest after an
  // edit (saveDocumentText) both land here, and both used to discard the
  // response entirely — a retry against a spent budget looked identical to a
  // retry that worked.
  //
  // A retry carries its own estimate, formed from the row rather than from a
  // file: the document is already filed, the person can see its name and size
  // on the row they pressed the button on, and without this a Re-run of a
  // 900-page scan would be refused by the handler's confirmation check for
  // want of an estimate that no dialog exists to show.
  await postIngest(documentId, accessToken, await declarationForFiled(documentId));
}

/** The estimate for a document already in the Vault, from its own row. */
async function declarationForFiled(documentId: string): Promise<IngestDeclaration | null> {
  const { data } = await supabase
    .from('documents')
    .select('source_filename, file_size_bytes, page_count')
    .eq('id', documentId)
    .maybeSingle();
  if (!data) return null;
  const item = estimateUploadItem({
    name: data.source_filename || '',
    bytes: Number(data.file_size_bytes) || 0,
    pages: Number(data.page_count) || undefined,
  });
  return documentNeedsConfirmation(item) ? declarationFor(item) : null;
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
    '.doc': 'application/msword',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return m[ext] || 'application/octet-stream';
}
