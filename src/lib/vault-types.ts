export interface VaultFile {
  id: string;
  name: string;
  path: string;
  size: string;
  sizeBytes: number;
  type: string;
  file: File;
  status: 'uploading' | 'indexing' | 'indexed' | 'error';
  /** Why ingestion failed (documents.processing_error) — shown on error rows. */
  errorMessage?: string;
  /** Extracted text content, available after indexing */
  textContent?: string;
  /** Set in persistent mode so the import panel can group by matter. */
  matterspace_id?: string;
  matterspace_name?: string;
  /** Persistent mode: object path in the vault-documents bucket. */
  storagePath?: string;
  /** True for AI-generated drafts kept in the "Generated Documents" view
   *  (in-memory; never goes through Supabase). */
  generated?: boolean;
  /** When the generated draft was created (ms epoch). */
  createdAt?: number;
}
