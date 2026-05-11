export interface VaultFile {
  id: string;
  name: string;
  path: string;
  size: string;
  sizeBytes: number;
  type: string;
  file: File;
  status: 'uploading' | 'indexing' | 'indexed' | 'error';
  /** Extracted text content, available after indexing */
  textContent?: string;
  /** Set in persistent mode so the import panel can group by matter. */
  matterspace_id?: string;
  matterspace_name?: string;
  /** Persistent mode: object path in the vault-documents bucket. */
  storagePath?: string;
}
