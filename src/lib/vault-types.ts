import type { OcrPending } from '../../lib/ingest-formats.mjs';

export interface VaultFile {
  id: string;
  name: string;
  path: string;
  size: string;
  sizeBytes: number;
  type: string;
  file: File;
  status: 'uploading' | 'indexing' | 'indexed' | 'error';
  /** Why ingestion failed (documents.processing_error) — shown on error rows,
   *  and on 'uploading' rows when the worker has noted a failed attempt and
   *  scheduled a retry ("Attempt 1 of 3 failed — …"). */
  errorMessage?: string;
  /** Extracted text content, available after indexing */
  textContent?: string;
  /** Set in persistent mode so the import panel can group by matter. */
  matterspace_id?: string;
  matterspace_name?: string;
  /** Persistent mode: object path in the vault-documents bucket. Set only
   *  once the bytes have landed, so the panel can tell "Uploading…" (browser
   *  still sending) from "Uploaded — processing" (server working on it). */
  storagePath?: string;
  /** Persistent mode: the pipeline's own stage while the document is
   *  non-terminal (documents.processing_status: pending / extracting /
   *  chunking / embedding). Drives the "Uploaded — processing: …" label. */
  stage?: string;
  /** Persistent mode: why a `ready` document holds no searchable text
   *  (documents.metadata.text_status — image_only, portfolio, …). Absent on
   *  documents that are actually indexed. */
  textStatus?: string;
  /** Persistent mode: pages a ready PDF still owes OCR, with the reason and
   *  the retry state (documents.metadata.ocr_pending). Present beside real
   *  passages — "Ready — 3 pages awaiting OCR" — or beside textStatus
   *  'ocr_pending' when nothing has been read yet. */
  ocrPending?: OcrPending;
  /** Persistent mode: the SecureSpace refused to send this file to an
   *  outside provider (documents.processing_status = 'held'). Terminal; the
   *  reason is in errorMessage; a retry would be refused identically. */
  held?: boolean;
  /** True for AI-generated drafts kept in the "Generated Documents" view
   *  (in-memory; never goes through Supabase). */
  generated?: boolean;
  /** When the generated draft was created (ms epoch). */
  createdAt?: number;
}
